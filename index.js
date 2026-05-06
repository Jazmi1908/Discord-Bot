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
  try {

    // ================= BUTTON =================
    if (interaction.isButton()) {
      const player = shoukaku.players.get(interaction.guild.id);
      if (!player) {
        return interaction.reply({ content: 'No song is playing!', ephemeral: true });
      }

      if (interaction.customId === 'pause_resume') {
        const isPaused = pausedState.get(interaction.guild.id) || false;
        await player.setPaused(!isPaused);
        pausedState.set(interaction.guild.id, !isPaused);

        return interaction.update({ components: [getMusicButtons(!isPaused)] });
      }

      if (interaction.customId === 'skip') {
        await player.stopTrack();
        return interaction.update({ content: 'Skipped!', components: [] });
      }

      if (interaction.customId === 'stop') {
        queues.delete(interaction.guild.id);
        pausedState.delete(interaction.guild.id);
        player.disconnect();

        return interaction.update({ content: 'Stopped and left VC.', components: [] });
      }

      return;
    }

    // ================= COMMAND =================
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // ================= PLAY =================
    if (commandName === 'play') {
      await interaction.deferReply(); // ✅ WAJIB paling awal

      const query = interaction.options.getString('query');
      const voiceChannel = interaction.member?.voice?.channel;

      if (!voiceChannel) {
        return interaction.editReply('Join voice channel dulu bro.');
      }

      const node = shoukaku.nodes.values().next().value;
      if (!node) {
        return interaction.editReply('Lavalink tak connect.');
      }

      let identifier = query.startsWith('http') ? query : `ytsearch:${query}`;

      let result;
      try {
        result = await node.rest.resolve(identifier);
      } catch (e) {
        console.error(e);
      }

      if (!result?.data?.length) {
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

      if (!queues.has(interaction.guild.id)) {
        queues.set(interaction.guild.id, []);
      }

      const queue = queues.get(interaction.guild.id);

      if (player.playing || player.current) {
        queue.push(track);
        return interaction.editReply(`Added to queue: **${track.info.title}**`);
      }

      await player.playTrack({ track: { encoded: track.encoded } });

      const embed = new EmbedBuilder()
        .setTitle('Now Playing')
        .setDescription(`**${track.info.title}**`)
        .setThumbnail(`https://img.youtube.com/vi/${track.info.identifier}/hqdefault.jpg`)
        .setColor(0xFF0000);

      await interaction.editReply({
        embeds: [embed],
        components: [getMusicButtons(false)]
      });

      // 🔥 FIX BESAR KAT SINI
      player.removeAllListeners('end');

      player.on('end', async () => {
        const activeQueue = queues.get(interaction.guild.id) || [];

        if (activeQueue.length > 0) {
          const next = activeQueue.shift();

          // ❌ BUG ASAL: guna track lama
          await player.playTrack({ track: { encoded: next.encoded } });

          interaction.channel.send(`Now playing: **${next.info.title}**`);
        } else {
          pausedState.delete(interaction.guild.id);
          await shoukaku.leaveVoiceChannel(interaction.guild.id);

          interaction.channel.send('Queue habis, keluar VC.');
        }
      });
    }

    // ================= QUEUE =================
    if (commandName === 'queue') {
      const queue = queues.get(interaction.guild.id) || [];

      if (!queue.length) {
        return interaction.reply({ content: 'Queue kosong.', ephemeral: true });
      }

      const list = queue.map((t, i) => `${i + 1}. ${t.info.title}`).join('\n');

      return interaction.reply(`**Queue:**\n${list}`);
    }

    // ================= CLEAR =================
    if (commandName === 'clear') {
      const amount = interaction.options.getInteger('amount');

      if (amount < 1 || amount > 100) {
        return interaction.reply({ content: '1 - 100 je.', ephemeral: true });
      }

      await interaction.channel.bulkDelete(amount, true);

      return interaction.reply({
        content: `Deleted ${amount} messages.`,
        ephemeral: true
      });
    }

  } catch (err) {
    console.error(err);

    // 🔥 SAFE REPLY (avoid unknown interaction)
    if (interaction.deferred || interaction.replied) {
      interaction.editReply('Ada error bro.');
    } else {
      interaction.reply({ content: 'Ada error bro.', ephemeral: true });
    }
  }
});

client.once('clientReady', () => {
  console.log(`Ready! Logged in as ${client.user.tag}`);
});

client.login(process.env.TOKEN);
