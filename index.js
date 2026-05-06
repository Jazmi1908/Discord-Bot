const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { Shoukaku, Connectors } = require('shoukaku');

const TOKEN = process.env.TOKEN;
console.log('Token received:', TOKEN ? 'YES - length: ' + TOKEN.length : 'NO - undefined');
const CLIENT_ID = process.env.CLIENT_ID;

const Nodes = [{
  name: 'main',
  url: '127.0.0.1:2333',
  auth: process.env.LAVALINK_PASSWORD || 'password123',
  secure: false,
  port: 2333
}];

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription(' a song')
    .addStringOption(opt => opt.setName('query').setDescription('Song name or URL').setRequired(true)),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue'),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear messages')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Number of messages to delete (max 100)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);
rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands })
  .then(() => console.log('Slash commands registered!'))
  .catch(console.error);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), Nodes);
shoukaku.on('error', (_, error) => console.error(error));

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

const queues = new Map();
const pausedState = new Map();

function getMusicButtons(paused = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('pause_resume')
      .setLabel(paused ? '▶ Resume' : '⏸ Pause')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('skip')
      .setLabel('⏭ Skip')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('stop')
      .setLabel('⏹ Stop')
      .setStyle(ButtonStyle.Danger),
  );
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const er = shoukaku.players.get(interaction.guild.id);
    if (!er) return interaction.reply({ content: 'No song is ing!', ephemeral: true });

    if (interaction.customId === 'pause_resume') {
      const isPaused = pausedState.get(interaction.guild.id) || false;
      await er.setPaused(!isPaused);
      pausedState.set(interaction.guild.id, !isPaused);
      await interaction.update({ components: [getMusicButtons(!isPaused)] });
    }

    if (interaction.customId === 'skip') {
      await er.stopTrack();
      await interaction.update({ content: 'Skipped!', components: [] });
    }

    if (interaction.customId === 'stop') {
      queues.delete(interaction.guild.id);
      pausedState.delete(interaction.guild.id);
      er.disconnect();
      await interaction.update({ content: 'Stopped and left voice channel.', components: [] });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

 if (commandName === 'play') {
  await interaction.deferReply(); // ← SEKALI je, buang yang kedua

  const query = interaction.options.getString('query');
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) return interaction.editReply('Join a voice channel first!');

  // BUANG baris deferReply kedua yang ada kat bawah tu
  const node = shoukaku.nodes.values().next().value;
    if (!node) return interaction.editReply('Tiada sambungan Lavalink node yang aktif.');

    let identifier = query;
    const isUrl = query.startsWith('http');

    if (!isUrl) {
      identifier = `ytsearch:${query}`;
    }

    let result;
    try {
      result = await node.rest.resolve(identifier);
    } catch (e) {
      console.error('Lavalink resolve error:', e);
    }

    if (!result || !result.data || !result.data.length) {
      try {
        result = await node.rest.resolve(`ytsearch:${query}`);
      } catch (e) {
        console.error('Fallback search failed:', e);
      }
    }

    if (!result || !result.data || !result.data.length) {
      return interaction.editReply('Song not found!');
    }

    const track = result.data[0];
    let player = shoukaku.players.get(interaction.guild.id);

    if (!player) {
      player = await shoukaku.joinVoiceChannel({
        guildId: interaction.guild.id,
        channelId: voiceChannel.id,
        shardId: 0,
      });
    }

    if (!queues.has(interaction.guild.id)) queues.set(interaction.guild.id, []);
    const queue = queues.get(interaction.guild.id);

    if (player.playing || player.current) {
      queue.push(track);
      return interaction.editReply(`Added to queue: **${track.info.title}**`);
    }

    await player.playTrack({ track: { encoded: track.encoded } });
    pausedState.set(interaction.guild.id, false);

    const embed = new EmbedBuilder()
      .setTitle('Now Playing')
      .setDescription(`**${track.info.title}**`)
      .setThumbnail(`https://img.youtube.com/vi/${track.info.identifier}/hqdefault.jpg`)
      .setURL(`https://www.youtube.com/watch?v=${track.info.identifier}`)
      .setColor(0xFF0000);

    await interaction.editReply({
      embeds: [embed],
      components: [getMusicButtons(false)]
    });

    player.removeAllListeners('end');
    player.on('end', async () => {
      const activeQueue = queues.get(interaction.guild.id) || [];
      if (activeQueue.length > 0) {
        const next = activeQueue.shift();
        await player.playTrack({ track: next.encoded });
        pausedState.set(interaction.guild.id, false);

        const nextEmbed = new EmbedBuilder()
          .setTitle('Now Playing')
          .setDescription(`**${next.info.title}**`)
          .setThumbnail(`https://img.youtube.com/vi/${next.info.identifier}/hqdefault.jpg`)
          .setURL(`https://www.youtube.com/watch?v=${next.info.identifier}`)
          .setColor(0xFF0000);

        interaction.channel.send({
          embeds: [nextEmbed],
          components: [getMusicButtons(false)]
        });
      } else {
        pausedState.delete(interaction.guild.id);
        player.disconnect();
        interaction.channel.send('Queue ended, leaving voice channel.');
      }
    });
  }

  if (commandName === 'queue') {
    const queue = queues.get(interaction.guild.id) || [];
    if (!queue.length) return interaction.reply('Queue is empty!');
    const list = queue.map((t, i) => `${i+1}. ${t.info.title}`).join('\n');
    interaction.reply(`**Queue:**\n${list}`);
  }

  if (commandName === 'clear') {
    const amount = interaction.options.getInteger('amount');
    if (amount < 1 || amount > 100) return interaction.reply({ content: 'Amount must be between 1 and 100!', ephemeral: true });

    await interaction.channel.bulkDelete(amount, true);
    interaction.reply({ content: `Deleted ${amount} messages!`, ephemeral: true });
  }
});

client.once('clientReady', () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
});

client.login(process.env.TOKEN);
