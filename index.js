const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  EmbedBuilder, 
  PermissionFlagsBits 
} = require('discord.js');

const { Shoukaku, Connectors } = require('shoukaku');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// ✅ FIXED Lavalink config (WAJIB guna ENV)
const Nodes = [{ 
  name: 'main',
  url: process.env.LAVALINK_HOST,
  auth: process.env.LAVALINK_PASSWORD,
  secure: true,                 
  port: parseInt(process.env.LAVALINK_PORT) || 443
}];

// ✅ Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song')
    .addStringOption(opt => 
      opt.setName('query').setDescription('Song name or URL').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue'),

  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear messages')
    .addIntegerOption(opt => 
      opt.setName('amount').setDescription('Max 100').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

].map(cmd => cmd.toJSON());

// ✅ Register commands
const rest = new REST({ version: '10' }).setToken(TOKEN);
rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

// ✅ Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// ✅ Shoukaku
const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), Nodes);

// Debug Lavalink
shoukaku.on('ready', (name) => console.log(`Lavalink ${name} connected`));
shoukaku.on('error', (_, err) => console.error('Lavalink error:', err));

// Queue
const queues = new Map();
const pausedState = new Map();

// Buttons
function getButtons(paused = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pause')
      .setLabel(paused ? '▶ Resume' : '⏸ Pause')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId('skip')
      .setLabel('⏭ Skip')
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId('stop')
      .setLabel('⏹ Stop')
      .setStyle(ButtonStyle.Danger)
  );
}

// 🎧 PLAY NEXT FUNCTION (IMPORTANT)
async function playNext(guildId, channel) {
  const player = shoukaku.players.get(guildId);
  const queue = queues.get(guildId) || [];

  if (!queue.length) {
    pausedState.delete(guildId);
    player?.disconnect();
    return channel.send('Queue habis, aku cabut dulu 👋');
  }

  const next = queue.shift();
  queues.set(guildId, queue);

  await player.playTrack({ track: next });
  pausedState.set(guildId, false);

  const embed = new EmbedBuilder()
    .setTitle('Now Playing')
    .setDescription(`**${next.info.title}**`)
    .setURL(`https://www.youtube.com/watch?v=${next.info.identifier}`)
    .setThumbnail(`https://img.youtube.com/vi/${next.info.identifier}/hqdefault.jpg`)
    .setColor(0xFF0000);

  channel.send({ embeds: [embed], components: [getButtons(false)] });
}

// 🎯 Interaction
client.on('interactionCreate', async (interaction) => {

  // BUTTONS
  if (interaction.isButton()) {
    const player = shoukaku.players.get(interaction.guild.id);
    if (!player) return interaction.reply({ content: 'Takde lagu bro', ephemeral: true });

    if (interaction.customId === 'pause') {
      const isPaused = pausedState.get(interaction.guild.id) || false;
      await player.setPaused(!isPaused);
      pausedState.set(interaction.guild.id, !isPaused);

      return interaction.update({ components: [getButtons(!isPaused)] });
    }

    if (interaction.customId === 'skip') {
      await player.stopTrack(); // trigger trackEnd
      return interaction.update({ content: 'Skip ⏭', components: [] });
    }

    if (interaction.customId === 'stop') {
      queues.delete(interaction.guild.id);
      pausedState.delete(interaction.guild.id);

      player.disconnect();
      return interaction.update({ content: 'Stop & keluar VC', components: [] });
    }
  }

  // COMMANDS
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'play') {
    const query = interaction.options.getString('query');
    const vc = interaction.member.voice.channel;

    if (!vc) return interaction.reply('Masuk VC dulu bro');

    await interaction.deferReply();

    const node = shoukaku.nodes.values().next().value;
    if (!node) return interaction.editReply('Lavalink tak connect bro');

    let result;
    try {
      result = await node.rest.resolve(
        query.startsWith('http') ? query : `ytsearch:${query}`
      );
    } catch (e) {
      console.error(e);
      return interaction.editReply('Error cari lagu');
    }

    if (!result?.data?.length) {
      return interaction.editReply('Lagu tak jumpa');
    }

    const track = result.data[0];

    // PLAYER
    let player = shoukaku.players.get(interaction.guild.id);

    if (!player) {
      player = await shoukaku.joinVoiceChannel({
        guildId: interaction.guild.id,
        channelId: vc.id,
        shardId: 0
      });

      // ✅ EVENT FIX (IMPORTANT)
      player.on('trackEnd', () => {
        playNext(interaction.guild.id, interaction.channel);
      });
    }

    // QUEUE
    if (!queues.has(interaction.guild.id)) {
      queues.set(interaction.guild.id, []);
    }

    const queue = queues.get(interaction.guild.id);

    // IF CURRENTLY PLAYING → QUEUE
    if (player.track) {
      queue.push(track);
      return interaction.editReply(`Masuk queue: **${track.info.title}**`);
    }

    // PLAY FIRST
    await player.playTrack({ track });
    pausedState.set(interaction.guild.id, false);

    const embed = new EmbedBuilder()
      .setTitle('Now Playing')
      .setDescription(`**${track.info.title}**`)
      .setURL(`https://www.youtube.com/watch?v=${track.info.identifier}`)
      .setThumbnail(`https://img.youtube.com/vi/${track.info.identifier}/hqdefault.jpg`)
      .setColor(0xFF0000);

    interaction.editReply({
      embeds: [embed],
      components: [getButtons(false)]
    });
  }

  if (interaction.commandName === 'queue') {
    const queue = queues.get(interaction.guild.id) || [];

    if (!queue.length) {
      return interaction.reply('Queue kosong bro');
    }

    const list = queue.map((t, i) => `${i + 1}. ${t.info.title}`).join('\n');
    interaction.reply(`Queue:\n${list}`);
  }

  if (interaction.commandName === 'clear') {
    const amount = interaction.options.getInteger('amount');

    if (amount < 1 || amount > 100) {
      return interaction.reply({ content: '1 - 100 je bro', ephemeral: true });
    }

    await interaction.channel.bulkDelete(amount, true);
    interaction.reply({ content: `Deleted ${amount}`, ephemeral: true });
  }
});

// READY
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);
