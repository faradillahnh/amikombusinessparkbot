
// ----------------
// modules

const storage = require('node-persist')
const TelegramBot = require('node-telegram-bot-api')
const commandLineArgs = require('command-line-args')
const markdownEscape = require('markdown-escape')
const marked = require('marked')

// ----------------
// marked renderer options for telegram HTML

const markedRenderer = new marked.Renderer()

markedRenderer.paragraph = (text) => `\n\n${text}`
markedRenderer.list = (text) => `\n${text}`
markedRenderer.listitem = (text) => `\n- ${text}`

// ----------------
// command line arguments

const DEFAULT_PERSISTENCE_PATH = './.persistence'

const optionDefinitions = [
  { name: 'api-token', alias: 't', type: String },
  { name: 'bot-username', alias: 'u', type: String },
  { name: 'persistence-path', alias: 'p', type: String }
]

const options = commandLineArgs(optionDefinitions)

if (!options['api-token']) throw new Error('❌   The --api-token (-t) option is required!')
if (!options['bot-username']) throw new Error('❌   The --bot-username (-u) option is required!')
if (!options['persistence-path']) console.warn(`⚠️   No --persistence-path (-p) defined, the default will be used: ${DEFAULT_PERSISTENCE_PATH}`)

// ----------------
// constants

//bot info
const API_TOKEN = options['api-token']
const BOT_USERNAME = options['bot-username']
const PERSISTENCE_PATH = options['persistence-path'] || DEFAULT_PERSISTENCE_PATH
const BOT_ID = +API_TOKEN.split(':')[0]

// built-in messages
const ERROR_MESSAGE_PREFIX = '⚠️ *Beep, boop, error!*'

const DEFAULT_MSG_TEMPLATE = `👋 *Selamat bergabung* $firstname ($safeusername) di $groupname yuk perkenalkan diri dan startup nya ! 😀
Kalau sobat memiliki permasalahan tentang startup, feel free to discuss with us 😀`

const START_MSG = 'Add me to a group! :)'

const INTRO_MSG = `👋 Hi!

Perkenalkan saya Sobat ABP bot, mulai saat ini saya akan menemani sobat di group $groupname`

const HELP_MSG = `*Selamat datang di bot help*

I will send a welcome message to every new member of a group.

I will start as soon as I get added to a group.

To customize the message, use the command \`/change_welcome_message <your new message>\`.

You can use the following templates:

- \`$username\`: the new member's username (with the @ character)
- \`$safeusername\`: the username, but if it isn't defined by the user, the first name will be used instead
- \`$firstname\`: the new member's first name
- \`$groupname\`: the group's name

IMPORTANT: \`$username\` could fail if the user hasn't defined a username, and when that happens the resulting string will be \`@undefined\`. Because of this, it is recommended to use \`$safeusername\` instead.

Keep in mind that *only* the user who introduces me to a group can execute this command.

Enjoy! 😊`

// ----------------
// bot instance

const bot = new TelegramBot(API_TOKEN, { polling: true })

// ----------------
// message composers

const composeMessage = (msg, member, groupname) => msg
  .replace(/([^$])(\$username)/g, (full, pre) => `${pre}@${markdownEscape(member.username)}`)
  .replace(/([^$])(\$firstname)/g, (full, pre) => `${pre}${markdownEscape(member.first_name)}`)
  .replace(/([^$])(\$groupname)/g, (full, pre) => `${pre}${markdownEscape(groupname)}`)
  .replace(/([^$])(\$safeusername)/g, (full, pre) => member.username
    ? `${pre}@${markdownEscape(member.username)}`
    : `${pre}@${markdownEscape(member.first_name)}`)
  // remove extra "$" in $$username / $$firstname / $$groupname
  .replace(/\$\$(username|safeusername|firstname|groupname)/g, (full, match) => `$${markdownEscape(match)}`)

const composeIntroMessage = (owner, groupName) => composeMessage(INTRO_MSG, owner, groupName)

const composeErrorMessage = msg => `${ERROR_MESSAGE_PREFIX} ${msg}`

// ----------------
// helpers

const sendMessage = (chatId, msg) => bot.sendMessage(chatId, marked(msg, { renderer: markedRenderer }), { parse_mode: 'HTML' })

const sendErrorMessage = (chatId, msg) => sendMessage(chatId, composeErrorMessage(msg))

const isGroup = msg => ['group', 'supergroup'].indexOf(msg.chat.type) > -1

// ----------------
// data

// message template
const msgTemplates = {}

const getMsgTemplateKey = chatId => `${chatId}_msg_template`

const getMsgTemplate = async chatId => {
  // already loaded in memory
  if (msgTemplates[chatId]) return msgTemplates[chatId]

  // persisted
  const storedTemplate = await storage.getItem(getMsgTemplateKey(chatId))
  if (storedTemplate) {
    msgTemplates[chatId] = storedTemplate // load in memory
    return storedTemplate
  }

  // not initialized
  msgTemplates[chatId] = DEFAULT_MSG_TEMPLATE
  return DEFAULT_MSG_TEMPLATE
}

const setMsgTemplate = async (chatId, msgTemplate) => {
  await storage.setItem(getMsgTemplateKey(chatId), msgTemplate)
  msgTemplates[chatId] = msgTemplate
}

const removeMsgTemplate = async chatId => {
  delete msgTemplates[chatId]
  await storage.removeItem(`${chatId}_msg_template`)
}

// owner id
const getOwnerIdKey = chatId => `${chatId}_owner_id`

const getOwnerId = chatId => storage.getItem(getOwnerIdKey(chatId))

const setOwnerId = (chatId, ownerId) => storage.setItem(getOwnerIdKey(chatId), ownerId)

const removeOwnerId = chatId => storage.removeItem(getOwnerIdKey(chatId))

// ----------------
// handlers

const notGroupHandler = async msg => sendMessage(msg.chat.id, '*Add me to a group first!*')

const newMemberHandler = async msg => {
  const chatId = msg.chat.id
  const groupName = msg.chat.title
  const newMember = msg.new_chat_members[0]

  if (newMember.id === BOT_ID) {
    await sendMessage(chatId, composeIntroMessage(msg.from, groupName))
    return setOwnerId(chatId, msg.from.id)
  } else if (!newMember.is_bot) return sendMessage(chatId, composeMessage(await getMsgTemplate(chatId), newMember, groupName))
}

const memberLeftHandler = async msg => {
  const chatId = msg.chat.id
  const member = msg.left_chat_member // oh, I 'member!

  if (member.id === BOT_ID) {
    await removeOwnerId(chatId)
    await removeMsgTemplate(chatId)
  }
}

const changeWelcomeMessageHandler = async (msg, match) => {
  if (!isGroup(msg)) return notGroupHandler(msg)

  const chatId = msg.chat.id
  const groupName = msg.chat.title
  const owner = msg.from

  const ownerId = await getOwnerId(chatId)

  if (owner.id !== ownerId) return sendErrorMessage(chatId, 'Only the user who introduced me to this group can change the message!')

  const msgTemplate = match[1].trim()

  if (!msgTemplate.length) return changeWelcomeMessageEmptyHandler(msg)

  await setMsgTemplate(chatId, msgTemplate)

  const exampleMessage = composeMessage(msgTemplate, owner, groupName)
  return sendMessage(chatId, `✔️ New welcome message set! Here's an example:\n\n${exampleMessage}`)
}

const changeWelcomeMessageEmptyHandler = msg => {
  if (!isGroup(msg)) return notGroupHandler(msg)

  return sendErrorMessage(msg.chat.id, `You can't set an empty message!`)
}

const helpHandler = msg => {
  // don't send the message if only the /help command is used
  // on a group without the bot's mention appended
  const mentionRegExp = new RegExp(`\\/help@${BOT_USERNAME}`)
  const withMention = !!msg.text.match(mentionRegExp)
  if (isGroup(msg) && !withMention) return

  return sendMessage(msg.chat.id, HELP_MSG)
}

const startHandler = msg => {
  // don't send the message on a group
  if (isGroup(msg)) return

  return sendMessage(msg.chat.id, START_MSG)
}

// ----------------
// execution

const run = async () => {
  await storage.init({ dir: PERSISTENCE_PATH })

  // send welcome message to new members (or intro message)
  bot.on('new_chat_members', newMemberHandler)

  // if bot leaves the group, remove its info
  bot.on('left_chat_member', memberLeftHandler)

  // change welcome message

  const baseChangeMsgCommandRegExp = `\\/change_welcome_message(?:@${BOT_USERNAME})?`

  // change the message on request
  const changeMsgCommandRegExp = new RegExp(`${baseChangeMsgCommandRegExp}\\s([\\s\\S]+)`)
  bot.onText(changeMsgCommandRegExp, changeWelcomeMessageHandler)

  // detect empty messages in command
  const changeMsgCommandRegExpEmpty = new RegExp(`${baseChangeMsgCommandRegExp}$`)
  bot.onText(changeMsgCommandRegExpEmpty, changeWelcomeMessageEmptyHandler)

  // display help message
  const helpCommandRegExp = new RegExp(`\\/help(?:@${BOT_USERNAME})?`)
  bot.onText(helpCommandRegExp, helpHandler)

  // answer to start command
  bot.onText(/\/start/, startHandler)
}

run()
