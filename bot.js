'use strict';

const

    fs      = require('fs'),
    telebot = require('telebot'),
    time    = require('./time'),
    Ioredis = require('Ioredis'),

    control = {
        config: process.argv[2] || './config.json',
        shutdown: (reason = "Unknown reason", fail) => {
            console.log(`Terminated: ${reason}. [SHUTDOWN_CLEAN]`);
            process.exit(!Boolean(fail));
        }
    };

let bot = { }, authTimer, spanningTimer = time.startTimer('ready');

bot.db = new Ioredis(control.config.db)

try {

    process.on('SIGINT', () => control.shutdown("SIGINT"));
    console.log(`\nRunning on node ${process.version} with process id ${process.pid}.\nLoading config from "${control.config}".`);
    control.config = JSON.parse(fs.readFileSync(control.config, 'utf-8'));
    Object.freeze(control.config);

    bot.api = new telebot(control.config.auth_token);
    bot.api.start();
    time.start();
    bot.time = time;
    bot.control = control;

    time.startTimer('auth');
    bot.api.getMe().then(me => {
        console.log(`Connected. (${authTimer = time.resolveTimer('auth')} ms)`);
        bot.profile = me;
        console.log(`Profile:\n  Id: ${me.id}\n  Name: ${me.first_name}\n  Username: @${me.username}`);
        setup();
    });

} catch (e) {
    console.log(String(e));
    control.shutdown("Unable to finish authentication", true);
}

function setup () {

    bot.functions = { };
    Object.freeze(bot);
    bot.api.on('text', receive);

    let modules = control.config.modules, failed  = 0;
    time.startTimer('loadAll');
    for (let i = 0; i < modules.length; i++) {
        try {
            require(modules[i].load).init(bot, modules[i].prefs);
        } catch (e) {
            console.log(`Failed to load module "${modules[i].load}". [MODULE_ERR]`);
            console.log(e);
            failed++;
        }
    }
    console.log(`Done loading modules: ${modules.length - failed} OK, ${failed} failed. (${time.resolveTimer('loadAll')} ms)`);

    let spanningTimer = time.resolveTimer('ready');
    console.log(`Ready to process messages. (${(spanningTimer - authTimer).toFixed(2)} ms | ${spanningTimer} ms)`);

}

function receive (message) {

    if (bot.time.isExpired(message.date))
        return;
    if (!message.entities)
        return;
    const firstEntity = message.entities[0];
    if (firstEntity.offset || firstEntity.type != 'bot_command')
        return;
    let commandEntity = message.text.substr(1, firstEntity.length - 1).toLowerCase();
    const botMention = commandEntity.match(/@.*/);
    if (botMention) {
        if (botMention[0].substr(1) != bot.profile.username)
            return;
        commandEntity = botMention.input.substr(0, botMention.index);
    }
    if (!bot.functions[commandEntity])
        return;

    message.tag = (response, format) => {
        switch (typeof response) {

            case 'number':
                response = String(response);
            case 'string':
                message.reply.text(response, {
                    parse: format ? 'HTML' : undefined,
                    reply: message.message_id
                }).catch(e => message.error(e.error_code, e.description));
            case 'undefined':
                break;

            case 'object':
                if (response && typeof response.then == 'function'
                    || response == null)
                    break;
            default:
                message.error("TYPE", `Function Error: returned ${typeof response} instead of string`);

        }
    };
    message.error = (code, desc) =>
        message.tag(`Failed. #E_${code} ⚠️\n${desc}.`);

    const funct = bot.functions[commandEntity];
    message.tag(funct.fn(message), funct.format);

}
