# Easy Timeout

[English](#english) | [日本語](#日本語)

---

## English

Easy Timeout is a lightweight self-hosted Discord bot that adds a **secondary defense layer** against raids and spam.

AutoMod cannot catch every abusive pattern. This bot lets trusted members or moderators immediately stop the damage by replying to a message with a trigger word, or by mentioning the target with a trigger word.

### Example

Reply to a harmful message:

```text
spam
```

Or mention the target:

```text
@user spam
```

If the sender has an allowed role, the bot immediately applies the configured timeout and notifies the configured roles.

### Default triggers

- `荒らし` / `あらし` / `アラシ`
- `スパム` / `すぱむ`
- `タイムアウト` / `たいむあうと`
- `raid` / `spam` / `timeout`

Trigger matching is intentionally strict: **normalized full-word match only**. The bot does not guess the meaning of free-form sentences.

For English trigger words, **uppercase and lowercase are treated as the same**. For example, `spam`, `Spam`, and `SPAM` all match the same trigger. Full-width/half-width forms and leading/trailing whitespace are also normalized.

Japanese Hiragana/Katakana variations are normalized as well, but Kanji readings are **not** guessed. If you want both a Kanji form and a Kana form, register them separately.

### Requirements

- Node.js 18+
- discord.js 14.x
- Discord **Message Content Intent** enabled

### Bot permissions

Recommended minimum permissions:

- View Channels
- Send Messages
- Read Message History
- Moderate Members

The bot role must be above members it needs to time out. Administrator permission is not required; you may grant it if you prefer simpler channel permission management. The **Mention @everyone, @here, and All Roles** permission is also optional and is only needed if Easy Timeout must ping a configured notification role that is not normally mentionable.

### Install

```bash
npm install
```

Set your token in `.env`:

```env
DISCORD_TOKEN=YOUR_BOT_TOKEN_HERE
```

Then run:

```bash
npm start
```

On first startup, the bot creates a default entry for every guild in `config.json`.

For safety, normal members cannot trigger emergency timeouts until an allowed role is configured. Members with **Manage Server** permission can always trigger and manage the bot.

### Commands

#### `/trigger`
Manage trigger words.

```text
/trigger add
/trigger edit
/trigger remove
```

#### `/config`
Manage emergency timeout settings.

```text
/config allowed-role add|remove
/config protected-role add|remove
/config mention-role add|remove
/config cooldown
/config timeout
```

Cooldown presets:

`None / 30 sec / 6 min / 30 min / 1 hour / 6 hours / 1 day`

Timeout presets:

`30 sec / 6 min / 30 min / 1 hour / 6 hours / 1 day`

Defaults:

- Cooldown: **6 minutes**
- Timeout: **1 hour**

#### `/status`
Shows the current guild configuration and permission diagnostics.

#### `/reload`
Reloads `config.json` without restarting the bot. Invalid JSON or invalid settings are rejected without replacing the currently loaded configuration.

### Safety model

- Only configured roles can activate the emergency timeout.
- Members with Manage Server can always activate/manage it.
- Server owner, bots, Administrators, Manage Server users, Moderate Members users, and configured protected roles cannot be targeted.
- Cooldown is per guild and per activating user.
- Cooldown starts only after a successful timeout.
- A user already timed out is not timed out again.
- No message deletion, kick, or ban is performed.
- Actions are printed to the process console and a notification is posted in the channel.

### Files

Easy Timeout itself is intentionally small:

```text
index.js     Easy Timeout logic
config.json  Per-guild configuration
.env         Bot token
```

`package.json`, `README.md`, `LICENSE`, and `.gitignore` are only project/distribution files.

Suggested project/repository name: `easy-timeout`  
Suggested deployment directory: `/opt/program/easy-timeout`  
Suggested systemd service name: `easy-timeout.service`

### License

MIT License — Copyright (c) 2026 翠雨氷霜

---

## 日本語

Easy Timeout は、AutoModをすり抜けた荒らし・スパムに対して、**二次防御**を追加する軽量セルフホスト型Discord Botです。

完璧なAutoModを作るのではなく、荒らしを目撃したメンバーやモデレーターが、その場で被害拡大を止めることを目的にしています。

### 使い方

荒らしの発言に返信して、

```text
荒らし
```

または対象をメンションして、

```text
@user 荒らし
```

と送信します。

発動者が許可ロールを持っていれば、Botが設定時間のタイムアウトを即時実行し、指定ロールへ通知します。

### デフォルト発動文言

- `荒らし` / `あらし` / `アラシ`
- `スパム` / `すぱむ`
- `タイムアウト` / `たいむあうと`
- `raid` / `spam` / `timeout`

誤爆防止のため、判定は**正規化後の完全一致**です。自由文の意味を推測して発動することはありません。

表記揺れは次のように扱います。

- **英字の大文字 / 小文字は区別しません。** `spam` / `Spam` / `SPAM` は同じ発動文言として扱います。
- **ひらがな / カタカナは区別しません。** `すぱむ` / `スパム` は同じ発動文言として扱います。
- **漢字はかなへ自動変換しません。** `荒らし` と `あらし` の両方に対応したい場合は、それぞれ個別に登録します。
- 全角 / 半角と前後の空白は自動で正規化します。

このため、漢字を勝手に別の読みへ変換することなく、ひらがな・カタカナや英字の大文字・小文字といった安全に扱える表記揺れだけを吸収します。

### 必要環境

- Node.js 18以上
- discord.js 14系
- Discord Developer Portalで **Message Content Intent** を有効化

### Bot権限

推奨する最低限の権限：

- チャンネルを見る
- メッセージを送信
- メッセージ履歴を読む
- メンバーをタイムアウト

Botロールは、タイムアウト対象にしたいメンバーより上に配置してください。

管理者権限は必須ではありません。チャンネルごとの権限設定が面倒な場合は、任意でBotロールへ管理者権限を付与して構いません。

「全員宛にメンション」権限も必須ではありません。通知先に設定したロールが通常メンション不可でも、Easy Timeoutから確実にPingしたい場合のみ任意で付与してください。

### インストール

```bash
npm install
```

`.env` にBot Tokenを設定します。

```env
DISCORD_TOKEN=YOUR_BOT_TOKEN_HERE
```

起動：

```bash
npm start
```

初回起動時、Botが参加している各サーバーのデフォルト設定が `config.json` に自動追加されます。

安全のため、最初は発動可能ロールが空です。**サーバー管理権限を持つユーザーは常に発動・設定可能**なので、まず `/config allowed-role add` で利用者を指定してください。

### コマンド

#### `/trigger`
発動文言を管理します。

```text
/trigger add
/trigger edit
/trigger remove
```

#### `/config`
緊急タイムアウトの設定を管理します。

```text
/config allowed-role add|remove
/config protected-role add|remove
/config mention-role add|remove
/config cooldown
/config timeout
```

クールタイム：

`なし / 30秒 / 6分 / 30分 / 1時間 / 6時間 / 1日`

タイムアウト時間：

`30秒 / 6分 / 30分 / 1時間 / 6時間 / 1日`

デフォルト：

- クールタイム：**6分**
- タイムアウト：**1時間**

#### `/status`
現在の設定と、Bot権限の診断結果を表示します。

#### `/reload`
Botを再起動せず `config.json` を再読込します。不正なJSONや不正な設定値の場合、現在読み込まれている正常な設定を維持します。

### 安全設計

- 許可ロールを持つユーザーのみ発動可能
- サーバー管理権限保持者は常に発動・管理可能
- サーバー所有者、Bot、Administrator、サーバー管理権限保持者、Moderate Members保持者、保護ロールは対象外
- クールタイムはサーバーごと・発動者ごと
- クールタイムはタイムアウト成功時のみ開始
- 既にタイムアウト中の対象には再発動しない
- メッセージ削除・Kick・BANは行わない
- 成功した発動はコンソールに記録し、発動チャンネルへ通知

### ファイル構成

Bot本体は意図的に小さくしています。

```text
index.js     Bot本体
config.json  サーバーごとの設定
.env         Bot Token
```

`package.json`、`README.md`、`LICENSE`、`.gitignore` は配布・プロジェクト管理用です。

### ライセンス

MIT License — Copyright (c) 2026 翠雨氷霜
