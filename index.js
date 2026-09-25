const fs = require('fs');
const path = require('path');
const {
  Client,
  Events,
  Locale,
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
  language: 'auto',
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
const LANGUAGES = new Set(['auto', 'ja', 'en']);
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
    if (g.language === undefined) g.language = 'auto';
    if (!LANGUAGES.has(g.language)) throw new Error(`Invalid language for guild ${guildId}: expected auto, ja, or en.`);
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

function messageLocale(guildConfig, fallbackLocale) {
  return guildConfig.language && guildConfig.language !== 'auto' ? guildConfig.language : fallbackLocale;
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

function roleGroup(name, description, addDescription, removeDescription, roleDescription) {
  return group => group
    .setName(name)
    .setDescription(description[0])
    .setDescriptionLocalizations({ [Locale.Japanese]: description[1] })
    .addSubcommand(sub => sub.setName('add')
      .setDescription(addDescription[0])
      .setDescriptionLocalizations({ [Locale.Japanese]: addDescription[1] })
      .addRoleOption(o => o.setName('role')
        .setDescription(roleDescription[0])
        .setDescriptionLocalizations({ [Locale.Japanese]: roleDescription[1] })
        .setRequired(true)))
    .addSubcommand(sub => sub.setName('remove')
      .setDescription(removeDescription[0])
      .setDescriptionLocalizations({ [Locale.Japanese]: removeDescription[1] })
      .addRoleOption(o => o.setName('role')
        .setDescription(roleDescription[0])
        .setDescriptionLocalizations({ [Locale.Japanese]: roleDescription[1] })
        .setRequired(true)));
}

const commands = [
  new SlashCommandBuilder()
    .setName('trigger')
    .setDescription('Manage the words that trigger Easy Timeout.').setDescriptionLocalizations({ [Locale.Japanese]: 'Easy Timeoutを発動するキーワードを管理します。' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('add').setDescription('Add a new trigger word.').setDescriptionLocalizations({ [Locale.Japanese]: 'Easy Timeoutを発動するキーワードを追加します。' })
      .addStringOption(o => o.setName('word').setDescription('The trigger word to add.').setDescriptionLocalizations({ [Locale.Japanese]: '追加する発動キーワード' }).setRequired(true).setMinLength(1).setMaxLength(32)))
    .addSubcommand(s => s.setName('edit').setDescription('Edit an existing trigger word.').setDescriptionLocalizations({ [Locale.Japanese]: '登録済みの発動キーワードを変更します。' })
      .addStringOption(o => o.setName('old').setDescription('The trigger word to replace.').setDescriptionLocalizations({ [Locale.Japanese]: '変更前の発動キーワード' }).setRequired(true).setMinLength(1).setMaxLength(32))
      .addStringOption(o => o.setName('new').setDescription('The new trigger word.').setDescriptionLocalizations({ [Locale.Japanese]: '変更後の発動キーワード' }).setRequired(true).setMinLength(1).setMaxLength(32)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a trigger word.').setDescriptionLocalizations({ [Locale.Japanese]: '登録済みの発動キーワードを削除します。' })
      .addStringOption(o => o.setName('word').setDescription('The trigger word to remove.').setDescriptionLocalizations({ [Locale.Japanese]: '削除する発動キーワード' }).setRequired(true).setMinLength(1).setMaxLength(32))),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure how Easy Timeout works in this server.').setDescriptionLocalizations({ [Locale.Japanese]: 'このサーバーでのEasy Timeoutの動作を設定します。' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup(roleGroup('allowed-role',
      ['Manage roles allowed to trigger Easy Timeout.', 'Easy Timeoutを発動できるロールを管理します。'],
      ['Allow a role to trigger Easy Timeout.', 'Easy Timeoutを発動できるロールを追加します。'],
      ['Remove a role from the allowed roles.', 'Easy Timeoutを発動できるロールから削除します。'],
      ['The role whose members can trigger Easy Timeout.', 'Easy Timeoutの発動を許可するロール']))
    .addSubcommandGroup(roleGroup('protected-role',
      ['Manage roles protected from Easy Timeout.', 'Easy Timeoutの対象にならない保護ロールを管理します。'],
      ['Protect a role from Easy Timeout.', 'Easy Timeoutの対象にならない保護ロールを追加します。'],
      ['Remove a role from the protected roles.', 'Easy Timeoutの保護ロールから削除します。'],
      ['The role to protect from Easy Timeout.', 'Easy Timeoutの対象外にするロール']))
    .addSubcommandGroup(roleGroup('mention-role',
      ['Manage roles notified when Easy Timeout is triggered.', 'Easy Timeout発動時に通知するロールを管理します。'],
      ['Add a role to notify when Easy Timeout is triggered.', 'Easy Timeout発動時にメンションする通知ロールを追加します。'],
      ['Remove a role from trigger notifications.', 'Easy Timeout発動時の通知ロールから削除します。'],
      ['The role to notify when Easy Timeout is triggered.', 'Easy Timeout発動時に通知するロール']))
    .addSubcommand(s => s.setName('cooldown').setDescription('Set how long a user must wait before triggering Easy Timeout again.').setDescriptionLocalizations({ [Locale.Japanese]: '同じユーザーが次にEasy Timeoutを発動できるまでの待機時間を設定します。' })
      .addIntegerOption(o => o.setName('value').setDescription('Time before the user can trigger Easy Timeout again.').setDescriptionLocalizations({ [Locale.Japanese]: '発動者が再度使用できるまでの時間' }).setRequired(true).addChoices(...cooldownChoices)))
    .addSubcommand(s => s.setName('timeout').setDescription('Set how long the target is timed out when Easy Timeout is triggered.').setDescriptionLocalizations({ [Locale.Japanese]: 'Easy Timeout発動時に対象をタイムアウトする時間を設定します。' })
      .addIntegerOption(o => o.setName('value').setDescription('How long the target will be timed out.').setDescriptionLocalizations({ [Locale.Japanese]: '対象を一時隔離する時間' }).setRequired(true).addChoices(...timeoutChoices))),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the current Easy Timeout settings and permission status.').setDescriptionLocalizations({ [Locale.Japanese]: '現在のEasy Timeoutの設定とBotの権限・動作状態を確認します。' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('reload')
    .setDescription('Reload Easy Timeout settings from config.json.').setDescriptionLocalizations({ [Locale.Japanese]: 'config.jsonを再読み込みしてEasy Timeoutの設定を反映します。' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('language')
    .setDescription('Change the language used by Easy Timeout in this server.')
    .setDescriptionLocalizations({ [Locale.Japanese]: 'このサーバーでEasy Timeoutが使用する言語を変更します。' })
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('language')
      .setDescription('Language used for Easy Timeout messages.')
      .setDescriptionLocalizations({ [Locale.Japanese]: 'Easy Timeoutのメッセージに使用する言語' })
      .setRequired(true)
      .addChoices(
        { name: 'Auto', value: 'auto' },
        { name: '日本語', value: 'ja' },
        { name: 'English', value: 'en' },
      )),
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

client.once(Events.ClientReady, async () => {
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
  let locale = messageLocale(g, interaction.locale);

  try {
    if (interaction.commandName === 'language') {
      const language = interaction.options.getString('language', true);
      if (!LANGUAGES.has(language)) {
        return privateReply(interaction, text(locale, 'Invalid language. Choose Auto, Japanese, or English.', '言語が不正です。Auto、日本語、Englishから選択してください。'));
      }
      const previous = g.language;
      g.language = language;
      try {
        saveConfig();
      } catch (error) {
        g.language = previous;
        throw error;
      }
      locale = messageLocale(g, interaction.locale);
      const confirmation = language === 'ja' ? '言語を日本語に変更しました。'
        : language === 'en' ? 'Language changed to English.'
          : text(locale, 'Language mode changed to Auto.', '言語設定を自動に変更しました。');
      return privateReply(interaction, confirmation);
    }

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
        ? `**Easy Timeout**\n\n**言語**\n${g.language === 'auto' ? 'Auto' : text(g.language, 'English', '日本語')}\n\n**診断**\n${checks}\n\n**発動文言**\n${g.triggers.join(' / ') || '—'}\n\n**発動可能ロール**\n${roleList(interaction.guild, g.allowedRoles)}\n\n**保護ロール**\n${roleList(interaction.guild, g.protectedRoles)}\n\n**クールタイム**\n${duration(g.cooldownSeconds, locale)}\n\n**タイムアウト**\n${duration(g.timeoutSeconds, locale)}\n\n**通知メンション**\n${roleList(interaction.guild, g.mentionRoles)}\n\nBotロールは対象メンバーより上に配置してください。`
        : `**Easy Timeout**\n\n**Language**\n${g.language === 'auto' ? 'Auto' : text(g.language, 'English', '日本語')}\n\n**Diagnostics**\n${checks}\n\n**Triggers**\n${g.triggers.join(' / ') || '—'}\n\n**Allowed roles**\n${roleList(interaction.guild, g.allowedRoles)}\n\n**Protected roles**\n${roleList(interaction.guild, g.protectedRoles)}\n\n**Cooldown**\n${duration(g.cooldownSeconds, locale)}\n\n**Timeout**\n${duration(g.timeoutSeconds, locale)}\n\n**Notification roles**\n${roleList(interaction.guild, g.mentionRoles)}\n\nPlace the bot role above members it needs to time out.`;

      return privateReply(interaction, body);
    }

    if (interaction.commandName === 'reload') {
      const next = readConfig();
      config = next;
      let changed = false;
      for (const guild of client.guilds.cache.values()) changed = ensureGuild(guild.id) || changed;
      if (changed) saveConfig();
      locale = messageLocale(config.guilds[interaction.guild.id], interaction.locale);
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

async function sendNotice(message, g) {
  const roleIds = g.mentionRoles.filter(id => id !== message.guild.id && message.guild.roles.cache.has(id));
  const pings = roleIds.map(id => `<@&${id}>`).join(' ');
  const body = text(messageLocale(g, message.guild.preferredLocale), 'Timeout applied.', 'タイムアウトを実行しました。');

  await message.channel.send({
    content: pings ? `${pings} ${body}` : body,
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
  const locale = messageLocale(g, message.guild.preferredLocale);

  if (!actor || !target || !canTrigger(actor, g)) return;
  if (target.id === actor.id) return replyNoPing(message, text(locale, 'You cannot target yourself.', '自分自身には発動できません。'));
  if (isProtected(target, g)) return replyNoPing(message, text(locale, 'That member is protected.', 'そのメンバーは保護されています。'));

  const bypassCooldown = actor.id === message.guild.ownerId || actor.permissions.has(PermissionFlagsBits.Administrator);
  const left = bypassCooldown ? 0 : cooldownLeft(message.guild.id, actor.id);
  if (left > 0) return replyNoPing(message, text(locale, `Cooldown: ${duration(left, locale)} remaining.`, `クールタイム中です。残り約${duration(left, locale)}。`));

  if (target.communicationDisabledUntilTimestamp && target.communicationDisabledUntilTimestamp > Date.now()) {
    return replyNoPing(message, text(locale, 'That member is already timed out.', 'そのメンバーは既にタイムアウト中です。'));
  }

  if (!target.moderatable) {
    return replyNoPing(message, text(locale, 'I cannot time out that member. Check my permissions and role position.', 'そのメンバーをタイムアウトできません。Bot権限とロール順を確認してください。'));
  }

  try {
    await target.timeout(g.timeoutSeconds * 1000, `Easy Timeout trigger by ${message.author.tag} (${message.author.id}): ${trigger}`);
    if (!bypassCooldown) startCooldown(message.guild.id, actor.id, g.cooldownSeconds);

    console.log(`[${new Date().toISOString()}] ${message.guild.name} | ${message.author.tag} -> ${target.user.tag} | ${g.timeoutSeconds}s | ${trigger}`);

    try {
      await sendNotice(message, g);
    } catch (error) {
      console.error('Notification error:', error.message);
    }
  } catch (error) {
    console.error('Timeout error:', error);
    await replyNoPing(message, text(locale, 'Failed to apply the timeout.', 'タイムアウトの実行に失敗しました。'));
  }
});

client.login(TOKEN);
