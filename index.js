const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

const BASE_DIR = __dirname;
const ENV_FILE = path.join(BASE_DIR, '.env');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');

// Tiny .env loader: keeps runtime dependencies to discord.js only.
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const i = text.indexOf('=');
    if (i < 1) continue;
    const key = text.slice(0, i).trim();
    let value = text.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN || TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.error('DISCORD_TOKEN is not set in .env');
  process.exit(1);
}

const DEFAULT_GUILD = {
  triggers: [
    '荒らし', 'あらし',
    'スパム',
    'タイムアウト',
    'raid', 'spam', 'timeout',
  ],
  allowedRoles: [],
  protectedRoles: [],
  cooldownSeconds: 360,
  timeoutSeconds: 3600,
  mentionRoles: [],
};

const COOLDOWNS = new Set([0, 30, 360, 1800, 3600, 21600, 86400]);
const TIMEOUTS = new Set([30, 360, 1800, 3600, 21600, 86400]);
const cooldowns = new Map();

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_GUILD));
}

function normalize(text) {
  return String(text)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function validateTrigger(word) {
  return typeof word === 'string' && word.trim().length >= 1 && word.trim().length <= 32 && !/[\r\n]/.test(word);
}

function validateConfig(data) {
  if (!data || typeof data !== 'object' || !data.guilds || typeof data.guilds !== 'object') {
    throw new Error('config.json must contain an object named "guilds".');
  }

  for (const [guildId, g] of Object.entries(data.guilds)) {
    if (!/^\d+$/.test(guildId) || !g || typeof g !== 'object') throw new Error(`Invalid guild entry: ${guildId}`);
    if (!Array.isArray(g.triggers) || !g.triggers.every(validateTrigger)) throw new Error(`Invalid triggers: ${guildId}`);
    for (const key of ['allowedRoles', 'protectedRoles', 'mentionRoles']) {
      if (!Array.isArray(g[key]) || !g[key].every(id => /^\d+$/.test(String(id)))) throw new Error(`Invalid ${key}: ${guildId}`);
    }
    if (!COOLDOWNS.has(g.cooldownSeconds)) throw new Error(`Invalid cooldownSeconds: ${guildId}`);
    if (!TIMEOUTS.has(g.timeoutSeconds)) throw new Error(`Invalid timeoutSeconds: ${guildId}`);
  }

  return data;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { guilds: {} };
  return validateConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
}

let config;
try {
  config = readConfig();
} catch (error) {
  console.error(`Failed to load config.json: ${error.message}`);
  process.exit(1);
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function ensureGuild(guildId) {
  if (!config.guilds[guildId]) {
    config.guilds[guildId] = cloneDefault();
    return true;
  }
  return false;
}

function isJa(locale) {
  return String(locale || '').toLowerCase().startsWith('ja');
}

function text(locale, en, ja) {
  return isJa(locale) ? ja : en;
}

function duration(seconds, locale) {
  const ja = isJa(locale);
  if (seconds === 0) return ja ? 'なし' : 'None';
  if (seconds < 60) return ja ? `${seconds}秒` : `${seconds} seconds`;
  if (seconds < 3600) return ja ? `${seconds / 60}分` : `${seconds / 60} minutes`;
  if (seconds < 86400) return ja ? `${seconds / 3600}時間` : `${seconds / 3600} hours`;
  return ja ? `${seconds / 86400}日` : `${seconds / 86400} day`;
}

function roleList(guild, ids) {
  if (!ids.length) return '—';
  return ids.map(id => id === guild.id ? '@everyone' : `<@&${id}>`).join(', ');
}

function canTrigger(member, guildConfig) {
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return guildConfig.allowedRoles.some(id => member.roles.cache.has(id));
}

function isProtected(member, guildConfig) {
  if (member.id === member.guild.ownerId || member.user.bot) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
  return guildConfig.protectedRoles.some(id => member.roles.cache.has(id));
}

function cooldownLeft(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const until = cooldowns.get(key) || 0;
  if (until <= Date.now()) {
    cooldowns.delete(key);
    return 0;
  }
  return Math.ceil((until - Date.now()) / 1000);
}

function startCooldown(guildId, userId, seconds) {
  if (seconds > 0) cooldowns.set(`${guildId}:${userId}`, Date.now() + seconds * 1000);
}

const cooldownChoices = [
  ['None / なし', 0], ['30 sec / 30秒', 30], ['6 min / 6分', 360],
  ['30 min / 30分', 1800], ['1 hour / 1時間', 3600], ['6 hours / 6時間', 21600], ['1 day / 1日', 86400],
].map(([name, value]) => ({ name, value }));

const timeoutChoices = cooldownChoices.filter(x => x.value !== 0);

function roleGroup(name, description) {
  return group => group
    .setName(name)
    .setDescription(description)
    .addSubcommand(sub => sub.setName('add').setDescription('Add role / ロールを追加')
      .addRoleOption(o => o.setName('role').setDescription('Role / ロール').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Remove role / ロールを削除')
      .addRoleOption(o => o.setName('role').setDescription('Role / ロール').setRequired(true)));
}

const commands = [
  new SlashCommandBuilder()
    .setName('trigger')
    .setDescription('Manage trigger words / 発動文言を管理')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('add').setDescription('Add trigger / 発動文言を追加')
      .addStringOption(o => o.setName('word').setDescription('Trigger word / 発動文言').setRequired(true).setMinLength(1).setMaxLength(32)))
    .addSubcommand(s => s.setName('edit').setDescription('Edit trigger / 発動文言を編集')
      .addStringOption(o => o.setName('old').setDescription('Current word / 現在の文言').setRequired(true).setMinLength(1).setMaxLength(32))
      .addStringOption(o => o.setName('new').setDescription('New word / 新しい文言').setRequired(true).setMinLength(1).setMaxLength(32)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove trigger / 発動文言を削除')
      .addStringOption(o => o.setName('word').setDescription('Trigger word / 発動文言').setRequired(true).setMinLength(1).setMaxLength(32))),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure Easy Timeout / Easy Timeout を設定')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(roleGroup('allowed-role', 'Roles allowed to trigger / 発動可能ロール'))
    .addSubcommandGroup(roleGroup('protected-role', 'Roles protected from timeout / 保護ロール'))
    .addSubcommandGroup(roleGroup('mention-role', 'Roles mentioned on activation / 発動時メンションロール'))
    .addSubcommand(s => s.setName('cooldown').setDescription('Set cooldown / クールタイムを設定')
      .addIntegerOption(o => o.setName('value').setDescription('Cooldown / クールタイム').setRequired(true).addChoices(...cooldownChoices)))
    .addSubcommand(s => s.setName('timeout').setDescription('Set timeout duration / タイムアウト時間を設定')
      .addIntegerOption(o => o.setName('value').setDescription('Timeout / タイムアウト').setRequired(true).addChoices(...timeoutChoices))),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show settings and diagnostics / 設定と診断を表示')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('reload')
    .setDescription('Reload config.json / config.jsonを再読込')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(command => command.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
  } catch (error) {
    console.error(`[${guild.id}] Failed to register commands:`, error.message);
  }
}

client.once('ready', async () => {
  let changed = false;
  for (const guild of client.guilds.cache.values()) changed = ensureGuild(guild.id) || changed;
  if (changed) saveConfig();
  await Promise.all([...client.guilds.cache.values()].map(registerCommands));
  console.log(`Ready: ${client.user.tag} | Guilds: ${client.guilds.cache.size}`);
});

client.on('guildCreate', async guild => {
  if (ensureGuild(guild.id)) saveConfig();
  await registerCommands(guild);
});

async function privateReply(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  if (interaction.replied || interaction.deferred) return interaction.followUp(payload);
  return interaction.reply(payload);
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return;

  ensureGuild(interaction.guild.id);
  const g = config.guilds[interaction.guild.id];
  const locale = interaction.locale;

  try {
    if (interaction.commandName === 'trigger') {
      const sub = interaction.options.getSubcommand();

      if (sub === 'add') {
        const word = interaction.options.getString('word', true).trim();
        if (!validateTrigger(word)) return privateReply(interaction, text(locale, 'Invalid trigger word.', '発動文言が不正です。'));
        if (g.triggers.some(x => normalize(x) === normalize(word))) return privateReply(interaction, text(locale, 'That trigger already exists.', 'その発動文言は既に登録されています。'));
        g.triggers.push(word);
      }

      if (sub === 'edit') {
        const oldWord = interaction.options.getString('old', true).trim();
        const newWord = interaction.options.getString('new', true).trim();
        const index = g.triggers.findIndex(x => normalize(x) === normalize(oldWord));
        if (index < 0) return privateReply(interaction, text(locale, 'Trigger not found.', '発動文言が見つかりません。'));
        if (!validateTrigger(newWord)) return privateReply(interaction, text(locale, 'Invalid trigger word.', '発動文言が不正です。'));
        if (g.triggers.some((x, i) => i !== index && normalize(x) === normalize(newWord))) return privateReply(interaction, text(locale, 'That trigger already exists.', 'その発動文言は既に登録されています。'));
        g.triggers[index] = newWord;
      }

      if (sub === 'remove') {
        const word = interaction.options.getString('word', true).trim();
        const before = g.triggers.length;
        g.triggers = g.triggers.filter(x => normalize(x) !== normalize(word));
        if (g.triggers.length === before) return privateReply(interaction, text(locale, 'Trigger not found.', '発動文言が見つかりません。'));
      }

      saveConfig();
      return privateReply(interaction, text(locale, 'Trigger settings saved.', '発動文言を保存しました。'));
    }

    if (interaction.commandName === 'config') {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      if (group) {
        const role = interaction.options.getRole('role', true);
        const key = group === 'allowed-role' ? 'allowedRoles' : group === 'protected-role' ? 'protectedRoles' : 'mentionRoles';

        if (group === 'mention-role' && role.id === interaction.guild.id) {
          return privateReply(interaction, text(locale, '@everyone cannot be used as a notification role.', '@everyone は通知メンションには指定できません。'));
        }

        if (sub === 'add' && !g[key].includes(role.id)) g[key].push(role.id);
        if (sub === 'remove') g[key] = g[key].filter(id => id !== role.id);
      } else if (sub === 'cooldown') {
        g.cooldownSeconds = interaction.options.getInteger('value', true);
      } else if (sub === 'timeout') {
        g.timeoutSeconds = interaction.options.getInteger('value', true);
      }

      saveConfig();
      return privateReply(interaction, text(locale, 'Configuration saved.', '設定を保存しました。'));
    }

    if (interaction.commandName === 'status') {
      const me = interaction.guild.members.me;
      const channelPerms = interaction.channel?.permissionsFor(me);
      const checks = [
        `${me?.permissions.has(PermissionFlagsBits.ModerateMembers) ? '✓' : '✗'} Moderate Members`,
        `${channelPerms?.has(PermissionFlagsBits.ViewChannel) ? '✓' : '✗'} View Channel`,
        `${channelPerms?.has(PermissionFlagsBits.SendMessages) ? '✓' : '✗'} Send Messages`,
        `${channelPerms?.has(PermissionFlagsBits.ReadMessageHistory) ? '✓' : '✗'} Read Message History`,
      ].join('\n');

      const body = isJa(locale)
        ? `**Easy Timeout**\n\n**診断**\n${checks}\n\n**発動文言**\n${g.triggers.join(' / ') || '—'}\n\n**発動可能ロール**\n${roleList(interaction.guild, g.allowedRoles)}\n\n**保護ロール**\n${roleList(interaction.guild, g.protectedRoles)}\n\n**クールタイム**\n${duration(g.cooldownSeconds, locale)}\n\n**タイムアウト**\n${duration(g.timeoutSeconds, locale)}\n\n**通知メンション**\n${roleList(interaction.guild, g.mentionRoles)}\n\nBotロールは対象メンバーより上に配置してください。`
        : `**Easy Timeout**\n\n**Diagnostics**\n${checks}\n\n**Triggers**\n${g.triggers.join(' / ') || '—'}\n\n**Allowed roles**\n${roleList(interaction.guild, g.allowedRoles)}\n\n**Protected roles**\n${roleList(interaction.guild, g.protectedRoles)}\n\n**Cooldown**\n${duration(g.cooldownSeconds, locale)}\n\n**Timeout**\n${duration(g.timeoutSeconds, locale)}\n\n**Notification roles**\n${roleList(interaction.guild, g.mentionRoles)}\n\nPlace the bot role above members it needs to time out.`;

      return privateReply(interaction, body);
    }

    if (interaction.commandName === 'reload') {
      const next = readConfig();
      config = next;
      let changed = false;
      for (const guild of client.guilds.cache.values()) changed = ensureGuild(guild.id) || changed;
      if (changed) saveConfig();
      return privateReply(interaction, text(locale, 'config.json reloaded.', 'config.json を再読込しました。'));
    }
  } catch (error) {
    console.error('Interaction error:', error);
    return privateReply(interaction, text(locale, `Error: ${error.message}`, `エラー: ${error.message}`));
  }
});

async function resolveTarget(message) {
  if (message.reference?.messageId) {
    try {
      const referenced = await message.fetchReference();
      const member = referenced.member || await message.guild.members.fetch(referenced.author.id);
      return { member, commandText: message.content };
    } catch {
      return null;
    }
  }

  if (message.mentions.members.size !== 1) return null;
  const member = message.mentions.members.first();
  const commandText = message.content.replace(new RegExp(`<@!?${member.id}>`, 'g'), '').trim();
  return { member, commandText };
}

async function sendNotice(message, target, g) {
  const locale = message.guild.preferredLocale;
  const roleIds = g.mentionRoles.filter(id => id !== message.guild.id && message.guild.roles.cache.has(id));
  const pings = roleIds.map(id => `<@&${id}>`).join(' ');
  const body = isJa(locale)
    ? `🚨 **緊急タイムアウトを実行しました**\n対象: ${target}\n発動者: ${message.author}\n時間: ${duration(g.timeoutSeconds, locale)}`
    : `🚨 **Easy Timeout activated**\nTarget: ${target}\nTriggered by: ${message.author}\nDuration: ${duration(g.timeoutSeconds, locale)}`;

  await message.channel.send({
    content: pings ? `${pings}\n${body}` : body,
    allowedMentions: { parse: [], roles: roleIds },
  });
}

async function replyNoPing(message, content) {
  try {
    await message.reply({ content, allowedMentions: { repliedUser: false, parse: [] } });
  } catch {}
}

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  const g = config.guilds[message.guild.id];
  if (!g) return;

  const resolved = await resolveTarget(message);
  if (!resolved) return;

  const trigger = g.triggers.find(word => normalize(word) === normalize(resolved.commandText));
  if (!trigger) return;

  const actor = message.member;
  const target = resolved.member;
  const locale = message.guild.preferredLocale;

  if (!actor || !target || !canTrigger(actor, g)) return;
  if (target.id === actor.id) return replyNoPing(message, text(locale, 'You cannot target yourself.', '自分自身には発動できません。'));
  if (isProtected(target, g)) return replyNoPing(message, text(locale, 'That member is protected.', 'そのメンバーは保護されています。'));

  const left = cooldownLeft(message.guild.id, actor.id);
  if (left > 0) return replyNoPing(message, text(locale, `Cooldown: ${duration(left, locale)} remaining.`, `クールタイム中です。残り約${duration(left, locale)}。`));

  if (target.communicationDisabledUntilTimestamp && target.communicationDisabledUntilTimestamp > Date.now()) {
    return replyNoPing(message, text(locale, 'That member is already timed out.', 'そのメンバーは既にタイムアウト中です。'));
  }

  if (!target.moderatable) {
    return replyNoPing(message, text(locale, 'I cannot time out that member. Check my permissions and role position.', 'そのメンバーをタイムアウトできません。Bot権限とロール順を確認してください。'));
  }

  try {
    await target.timeout(g.timeoutSeconds * 1000, `Easy Timeout trigger by ${message.author.tag} (${message.author.id}): ${trigger}`);
    startCooldown(message.guild.id, actor.id, g.cooldownSeconds);

    console.log(`[${new Date().toISOString()}] ${message.guild.name} | ${message.author.tag} -> ${target.user.tag} | ${g.timeoutSeconds}s | ${trigger}`);

    try {
      await sendNotice(message, target, g);
    } catch (error) {
      console.error('Notification error:', error.message);
    }
  } catch (error) {
    console.error('Timeout error:', error);
    await replyNoPing(message, text(locale, 'Failed to apply the timeout.', 'タイムアウトの実行に失敗しました。'));
  }
});

client.login(TOKEN);
